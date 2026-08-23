//! `uniq="true"` — make every row's tuple different from every other row's.
//!
//! The one invariant everything here is built around: values are only ever
//! **rearranged**, never replaced. Each column keeps exactly the multiset of
//! values it was drawn with, so a declared `percent=` share survives unchanged.
//! Uniqueness and an exact distribution are not in tension — they coexist
//! because the arrangement is a permutation.
//!
//! Three pieces:
//!
//! * [`upper_bound`] — a proven ceiling. Asking for more than this is
//!   impossible, so it is a safe reject before any work.
//! * [`capacity`] — a simulation over the quota numbers alone, giving a safe
//!   floor. It certifies a huge config in milliseconds without assembling a
//!   single row.
//! * [`arrange`] — the constructive builder: proportional fill, then swap
//!   repair.
//!
//! Pure: no DSL, no randomness, no input beyond the columns. The rearrangement
//! is a function of the values drawn, which is what lets it be checked against a
//! brute-force answer.

use std::collections::BTreeMap;

/// The separator that keys a tuple.
///
/// NUL, because it is the one character a generated value cannot contain. With a
/// space or a comma, `["a b", "c"]` and `["a", "b c"]` would key alike, and two
/// genuinely different rows would count as one duplicate — the exact mistake
/// this file exists to avoid.
const SEP: char = '\0';

/// Sweeps of swap repair before the arrangement is accepted as it stands.
const MAX_SWEEPS: usize = 8;

pub struct Arrangement {
    pub columns: Vec<Vec<String>>,
    pub distinct: usize,
}

fn key_of(row: &[String]) -> String {
    row.join(&SEP.to_string())
}

/// Counts of each distinct value in a column, in first-seen order.
pub fn value_counts(column: &[String]) -> Vec<usize> {
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    let mut order: Vec<&str> = Vec::new();
    for v in column {
        if !counts.contains_key(v.as_str()) {
            order.push(v);
        }
        *counts.entry(v).or_insert(0) += 1;
    }
    order.into_iter().map(|v| counts[v]).collect()
}

/// A proven upper bound on the distinct tuples these value-counts can produce.
///
/// It never undercounts, which is the property that matters: a config asking for
/// more than this is definitely impossible and can be refused immediately, with
/// no risk of refusing one that would have worked.
pub fn upper_bound(column_counts: &[Vec<usize>]) -> usize {
    let mut need = 1usize;
    for counts in by_deviation(column_counts) {
        need = counts.iter().map(|c| (*c).min(need)).sum();
    }
    need
}

/// A safe lower bound, simulated over the counts alone.
///
/// The builder always does at least this well, so reaching `need` here certifies
/// the config without touching any data — which is what makes a billion-row
/// config answerable in milliseconds.
pub fn capacity(column_counts: &[Vec<usize>], need: usize) -> usize {
    let sorted = by_deviation(column_counts);
    let Some(first) = sorted.first() else {
        return 0;
    };

    let mut profile: Vec<usize> = (*first).clone();
    for counts in sorted.iter().skip(1) {
        let mut pool: Vec<usize> = (*counts).clone();
        let mut next: Vec<usize> = Vec::new();
        let mut groups = profile.clone();
        groups.sort_by(|a, b| b.cmp(a));

        for group_size in groups {
            let live: Vec<(usize, usize)> = pool
                .iter()
                .enumerate()
                .filter(|(_, cap)| **cap > 0)
                .map(|(i, cap)| (i, *cap))
                .collect();
            let split = proportional_split(group_size, &live);
            for (x, (index, _)) in live.iter().enumerate() {
                if split[x] > 0 {
                    next.push(split[x]);
                    pool[*index] -= split[x];
                }
            }
        }

        profile = next;
        // The count only grows with each further column, so reaching the target
        // certifies it.
        if profile.len() >= need {
            return profile.len();
        }
    }
    profile.len()
}

/// Rearrange the columns so as many rows as possible carry a distinct tuple.
pub fn arrange(columns: &[Vec<String>]) -> Arrangement {
    let k = columns.len();
    if k == 0 {
        return Arrangement {
            columns: Vec::new(),
            distinct: 0,
        };
    }
    if columns[0].is_empty() {
        return Arrangement {
            columns: vec![Vec::new(); k],
            distinct: 0,
        };
    }

    // Balanced columns first. A column whose values are evenly spread offers the
    // most freedom, so spending it early leaves the lopsided ones an easier job.
    let deviations: Vec<f64> = columns.iter().map(|c| std_dev(&value_counts(c))).collect();
    let mut order: Vec<usize> = (0..k).collect();
    order.sort_by(|a, b| {
        deviations[*a]
            .partial_cmp(&deviations[*b])
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.cmp(b))
    });

    let sorted_columns: Vec<&Vec<String>> = order.iter().map(|i| &columns[*i]).collect();
    let mut rows = build_rows(&sorted_columns);
    repair_rows(&mut rows);

    let mut result: Vec<Vec<String>> = vec![Vec::new(); k];
    for (sorted_k, original) in order.iter().enumerate() {
        result[*original] = rows.iter().map(|row| row[sorted_k].clone()).collect();
    }

    let seen: std::collections::BTreeSet<String> = rows.iter().map(|r| key_of(r)).collect();
    Arrangement {
        columns: result,
        distinct: seen.len(),
    }
}

/// Assemble rows column by column, spreading each column's values across the
/// groups so far.
/// Give a group of `g` rows `g` DISTINCT values, when the column still has that
/// many left.
///
/// Two rows in the same group agree on every column before this one, so they are
/// distinct only if they differ HERE. The proportional split does not know that:
/// it hands out values in proportion to remaining stock, which repeats a value
/// inside a group as soon as one value dominates. Every such repeat is a
/// duplicate row, and duplicates are what the repair then spends quadratic time
/// undoing.
///
/// Taking the `g` largest stocks costs nothing in exactness — the column's
/// multiset is fixed either way, and this only chooses WHICH row gets which
/// value.
///
/// Returns false when the column has fewer values left than the group has rows;
/// the proportional path handles that instead.
fn deal_distinct(
    pool: &mut BTreeMap<String, usize>,
    pool_order: &[String],
    indexes: &[usize],
    rows: &mut [Vec<String>],
) -> bool {
    let g = indexes.len();
    // `at` counts every entry, not only the live ones, so a tie is broken by
    // first appearance the same way in every implementation.
    let mut live: Vec<(usize, usize, &String)> = Vec::new();
    for (at, key) in pool_order.iter().enumerate() {
        let stock = pool[key];
        if stock > 0 {
            live.push((stock, at, key));
        }
    }
    if live.len() < g {
        return false;
    }

    live.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    let chosen: Vec<(String, usize)> = live
        .iter()
        .take(g)
        .map(|(stock, _at, key)| ((*key).clone(), *stock))
        .collect();
    for (m, (value, stock)) in chosen.into_iter().enumerate() {
        pool.insert(value.clone(), stock - 1);
        rows[indexes[m]].push(value);
    }
    true
}

fn build_rows(columns: &[&Vec<String>]) -> Vec<Vec<String>> {
    let first = columns[0];
    let n = first.len();
    let mut rows: Vec<Vec<String>> = first.iter().map(|v| vec![v.clone()]).collect();

    for column in columns.iter().skip(1) {
        let mut pool_order: Vec<String> = Vec::new();
        let mut pool: BTreeMap<String, usize> = BTreeMap::new();
        for v in column.iter() {
            if !pool.contains_key(v) {
                pool_order.push(v.clone());
            }
            *pool.entry(v.clone()).or_insert(0) += 1;
        }

        let mut group_order: Vec<String> = Vec::new();
        let mut groups: BTreeMap<String, Vec<usize>> = BTreeMap::new();
        for (j, row) in rows.iter().enumerate().take(n) {
            let key = key_of(row);
            groups.entry(key.clone()).or_insert_with(|| {
                group_order.push(key.clone());
                Vec::new()
            });
            groups.get_mut(&key).expect("just inserted").push(j);
        }

        // Largest groups first: they are the ones most in need of diversity, and
        // the pool is finite, so serving them last would leave them whatever
        // nobody else wanted.
        let mut by_size: Vec<Vec<usize>> =
            group_order.iter().map(|key| groups[key].clone()).collect();
        // A STABLE sort by descending size: groups of equal size keep the order
        // they were first seen in, which is what makes the arrangement a
        // function of the values rather than of the map's iteration.
        by_size.sort_by_key(|g| std::cmp::Reverse(g.len()));

        for indexes in by_size {
            if deal_distinct(&mut pool, &pool_order, &indexes, &mut rows) {
                continue;
            }

            let mut live_keys: Vec<String> = Vec::new();
            let mut live: Vec<(usize, usize)> = Vec::new();
            for key in &pool_order {
                let cap = pool[key];
                if cap > 0 {
                    live.push((live.len(), cap));
                    live_keys.push(key.clone());
                }
            }

            let split = proportional_split(indexes.len(), &live);

            let mut deck: Vec<String> = Vec::new();
            for (x, key) in live_keys.iter().enumerate() {
                for _ in 0..split[x] {
                    deck.push(key.clone());
                }
            }
            deck.sort();

            for (di, j) in indexes.into_iter().enumerate() {
                let v = if di < deck.len() {
                    deck[di].clone()
                } else if deck.is_empty() {
                    String::new()
                } else {
                    deck[deck.len() - 1].clone()
                };
                if let Some(remaining) = pool.get_mut(&v) {
                    *remaining = remaining.saturating_sub(1);
                }
                rows[j].push(v);
            }
        }
    }

    rows
}

/// Swap repair: while a row duplicates another, trade one of its cells with
/// another row's cell in the same column whenever that strictly reduces the
/// number of duplicates.
///
/// Swapping within a column is what preserves the multiset — the values move
/// between rows but the column still holds exactly what it held.
fn repair_rows(rows: &mut [Vec<String>]) {
    let n = rows.len();
    let k = rows.first().map_or(0, Vec::len);

    for _ in 0..MAX_SWEEPS {
        let mut improved = false;
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        for r in rows.iter() {
            *counts.entry(key_of(r)).or_insert(0) += 1;
        }

        for i in 0..n {
            let old_i = key_of(&rows[i]);
            if counts.get(&old_i).copied().unwrap_or(0) <= 1 {
                continue;
            }

            let mut done = false;
            for col in 0..k {
                if done {
                    break;
                }
                for j in 0..n {
                    if done {
                        break;
                    }
                    if j == i || rows[i][col] == rows[j][col] {
                        continue;
                    }

                    let old_j = key_of(&rows[j]);
                    let mut ni = rows[i].clone();
                    let mut nj = rows[j].clone();
                    ni[col] = rows[j][col].clone();
                    nj[col] = rows[i][col].clone();
                    let new_i = key_of(&ni);
                    let new_j = key_of(&nj);

                    let before = 1 + usize::from(counts.get(&old_j).copied().unwrap_or(0) > 1);
                    // Only four tallies can change, so they are adjusted rather
                    // than recounted. The obvious version copies the whole map
                    // inside the innermost loop, which makes a sweep cubic in
                    // the row count and never finishes on real data.
                    let after = usize::from(
                        trial_count(&counts, &new_i, &new_i, &new_j, &old_i, &old_j) > 1,
                    ) + usize::from(
                        trial_count(&counts, &new_j, &new_i, &new_j, &old_i, &old_j) > 1,
                    );

                    if after < before {
                        rows[i] = ni;
                        rows[j] = nj;
                        *counts.entry(old_i.clone()).or_insert(0) -= 1;
                        *counts.entry(old_j.clone()).or_insert(0) -= 1;
                        *counts.entry(new_i.clone()).or_insert(0) += 1;
                        *counts.entry(new_j.clone()).or_insert(0) += 1;
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
}

fn trial_count(
    counts: &BTreeMap<String, usize>,
    key: &str,
    new_i: &str,
    new_j: &str,
    old_i: &str,
    old_j: &str,
) -> i64 {
    counts.get(key).copied().unwrap_or(0) as i64 + i64::from(key == new_i) + i64::from(key == new_j)
        - i64::from(key == old_i)
        - i64::from(key == old_j)
}

/// Largest-remainder split of `total` over parts of `(index, cap)`.
fn proportional_split(total: usize, parts: &[(usize, usize)]) -> Vec<usize> {
    let mut result = vec![0usize; parts.len()];
    if parts.is_empty() {
        return result;
    }

    let sum_weight: f64 = parts.iter().map(|p| p.1 as f64).sum();
    let mut remainders = vec![0f64; parts.len()];
    let mut assigned = 0usize;
    for (i, part) in parts.iter().enumerate() {
        let exact = if sum_weight == 0.0 {
            0.0
        } else {
            total as f64 * part.1 as f64 / sum_weight
        };
        result[i] = part.1.min(exact.floor() as usize);
        remainders[i] = exact - exact.floor();
        assigned += result[i];
    }

    let mut order: Vec<usize> = (0..parts.len()).collect();
    order.sort_by(|a, b| {
        remainders[*b]
            .partial_cmp(&remainders[*a])
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.cmp(b))
    });
    for i in order {
        if assigned >= total {
            break;
        }
        if result[i] < parts[i].1 {
            result[i] += 1;
            assigned += 1;
        }
    }

    // Whatever the clamping left over, round-robin into the parts that still
    // have room.
    let mut i = 0usize;
    while assigned < total {
        if result[i] < parts[i].1 {
            result[i] += 1;
            assigned += 1;
        } else if !parts.iter().enumerate().any(|(x, p)| result[x] < p.1) {
            break;
        }
        i = (i + 1) % result.len();
    }

    result
}

/// Column-count vectors ordered by how evenly spread they are, most balanced
/// first.
fn by_deviation(items: &[Vec<usize>]) -> Vec<&Vec<usize>> {
    let deviations: Vec<f64> = items.iter().map(|c| std_dev(c)).collect();
    let mut order: Vec<usize> = (0..items.len()).collect();
    order.sort_by(|a, b| {
        deviations[*a]
            .partial_cmp(&deviations[*b])
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.cmp(b))
    });
    order.into_iter().map(|i| &items[i]).collect()
}

fn std_dev(nums: &[usize]) -> f64 {
    let n = nums.len();
    if n < 2 {
        return 0.0;
    }
    let mean = nums.iter().sum::<usize>() as f64 / n as f64;
    let variance: f64 = nums
        .iter()
        .map(|v| (*v as f64 - mean) * (*v as f64 - mean))
        .sum();
    (variance / (n - 1) as f64).sqrt()
}
