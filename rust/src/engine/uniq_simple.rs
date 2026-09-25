//! `uniq="true"` on a SIMPLE sequence: every row gets a different value.
//!
//! A compound's `uniq` rearranges what was already drawn — it can keep the
//! per-value proportions because a tuple has room to vary. A single column has
//! no such room: proportions and uniqueness contradict each other the moment
//! any value's share exceeds one row. So here `uniq` changes the DRAW itself:
//! values are sampled WITHOUT REPLACEMENT. A weighted pool keeps its meaning —
//! frequent values are more likely to make the cut — but nothing appears
//! twice.
//!
//! Draw budget: exactly one PRNG draw per pick, whatever the pool. The
//! reference is `typescript/src/sequence/uniq-simple.ts`; the numbers here
//! must match it byte for byte.

use std::collections::{HashMap, HashSet};

use crate::engine::{invalid, EngineResult};
use crate::generators::advanced_regex;
use crate::generators::file as file_gen;
use crate::generators::regex;
use crate::model::config::Gen;
use crate::prng::Sfc32;

use super::memory::Env;

struct Pool {
    values: Vec<String>,
    weights: Vec<f64>,
}

/// `count` pairwise-different values, or a refusal that names both numbers.
pub fn build(
    name: &str,
    gen: &Gen,
    count: usize,
    prng: &mut Sfc32,
    env: &Env,
) -> EngineResult<Vec<String>> {
    if gen.gen_type == "number" {
        return unique_numbers(name, gen, count, prng);
    }
    if gen.gen_type == "regex" {
        return unique_regex(name, gen, count, prng, env);
    }
    if gen.gen_type == "advanced_regex" {
        return unique_advanced_regex(name, gen, count, prng, env);
    }
    let pool = pool_of(name, gen, env)?;
    if pool.values.len() < count {
        return invalid(&format!(
            "uniq: sequence \"{name}\" cannot produce {count} unique values — its source \
             holds only {} distinct values. Add more values, or lower the count.",
            pool.values.len()
        ));
    }
    Ok(sample_without_replacement(&pool, count, prng))
}

/// One draw per pick: a point in the remaining total weight, walked in order.
fn sample_without_replacement(pool: &Pool, count: usize, prng: &mut Sfc32) -> Vec<String> {
    let weights = &pool.weights;
    let mut total: f64 = 0.0;
    for w in weights {
        total += w;
    }
    let mut taken = vec![false; weights.len()];
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let target = prng.next() * total;
        let mut acc = 0.0f64;
        let mut picked: isize = -1;
        for (i, w) in weights.iter().enumerate() {
            if taken[i] {
                continue;
            }
            acc += w;
            if target < acc {
                picked = i as isize;
                break;
            }
        }
        // Floating summation can leave the target a hair past the last value's
        // edge; the last remaining value is the only honest answer then.
        if picked < 0 {
            for i in (0..weights.len()).rev() {
                if !taken[i] {
                    picked = i as isize;
                    break;
                }
            }
        }
        if picked < 0 {
            break;
        }
        let at = picked as usize;
        taken[at] = true;
        total -= weights[at];
        out.push(pool.values[at].clone());
    }
    out
}

/// Unique integers from a plain `a..b` range: draw normally, redraw on repeat.
fn unique_numbers(
    name: &str,
    gen: &Gen,
    count: usize,
    prng: &mut Sfc32,
) -> EngineResult<Vec<String>> {
    let Some((lo, hi)) = plain_int_range(gen) else {
        return invalid(&format!(
            "uniq: sequence \"{name}\" — {}",
            unsupported_reason(gen)
        ));
    };
    let size = (hi - lo + 1) as u64;
    if (size as usize) < count {
        return invalid(&format!(
            "uniq: sequence \"{name}\" cannot produce {count} unique values — the range \
             {lo}..{hi} holds only {size} integers. Widen the range, or lower the count."
        ));
    }
    let mut seen: HashSet<i64> = HashSet::new();
    let mut out = Vec::with_capacity(count);
    while out.len() < count {
        let n = lo + (prng.next() * size as f64).floor() as i64;
        if !seen.insert(n) {
            continue;
        }
        out.push(n.to_string());
    }
    Ok(out)
}

/// Unique strings from a `type="regex"` pattern: redraw on a repeat, as the range above does.
///
/// What uniqueness needs from a source is its size, so a count it cannot meet is refused before
/// drawing — and a finite pattern knows its size ([`regex::space_size`]). Each value is one walk
/// of the pattern from the unique stream, a repeat costs one more walk, and a run of repeats
/// longer than [`stall_limit`] is refused rather than looped on.
fn unique_regex(
    name: &str,
    gen: &Gen,
    count: usize,
    prng: &mut Sfc32,
    env: &Env,
) -> EngineResult<Vec<String>> {
    let pattern = gen.attrs.get("value").map(String::as_str).unwrap_or("");
    let limit = regex::limit_of(&gen.attrs, env.config.regex_max_length)?;
    let space = regex::space_size(pattern, limit)?;
    if space < count as u64 {
        return invalid(&format!(
            "uniq: sequence \"{name}\" cannot produce {count} unique values — the pattern \
             \"{pattern}\" makes at most {space} different strings. Widen the pattern, or \
             lower the count."
        ));
    }
    let drawer = regex::Drawer::new(&gen.attrs, env.config.regex_max_length)?;
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::with_capacity(count);
    let mut repeats: u64 = 0;
    while out.len() < count {
        let value = drawer.draw(prng);
        if seen.contains(&value) {
            repeats += 1;
            if repeats > stall_limit(space, out.len() as u64) {
                return invalid(&format!(
                    "uniq: sequence \"{name}\" — after {} unique values the pattern \
                     \"{pattern}\" produced only ones already drawn, {repeats} in a row. Its \
                     space of at most {space} strings is nearly used up, or fewer of them differ \
                     than its shape suggests. Widen the pattern, or lower the count.",
                    out.len()
                ));
            }
            continue;
        }
        repeats = 0;
        seen.insert(value.clone());
        out.push(value);
    }
    Ok(out)
}

/// Unique strings from an `advanced_regex` pattern, with every weighted share kept exact.
///
/// The column is dealt as it would be without `uniq`; a value that repeats is redrawn along the
/// branches its row was dealt. Three refusals, in the order a reader meets them: the whole pattern
/// too small, one share too small (named by its percentage, before any redraw, wherever the shares
/// can be counted apart), and a run of repeats too long. See the TypeScript reference,
/// `uniqueAdvancedRegexValues`, for the why.
fn unique_advanced_regex(
    name: &str,
    gen: &Gen,
    count: usize,
    prng: &mut Sfc32,
    env: &Env,
) -> EngineResult<Vec<String>> {
    let pattern = gen.attrs.get("value").map(String::as_str).unwrap_or("");
    let column = advanced_regex::plan(&gen.attrs, count, env.config.regex_max_length, prng)?;
    if column.total_space < count as u64 {
        return invalid(&format!(
            "uniq: sequence \"{name}\" cannot produce {count} unique values — the pattern \
             \"{pattern}\" makes at most {} different strings. Widen the pattern, or lower the \
             count.",
            column.total_space
        ));
    }

    // Rows per share, in the order the shares first appear in the column.
    let mut order: Vec<&str> = Vec::new();
    let mut rows_in: HashMap<&str, u64> = HashMap::new();
    for key in &column.path_keys {
        let n = rows_in.entry(key.as_str()).or_insert(0);
        if *n == 0 {
            order.push(key.as_str());
        }
        *n += 1;
    }
    for key in &order {
        let rows = rows_in[key];
        let path = column.describe_path(key);
        if let Some(space) = column.path_space(key) {
            if !path.is_empty() && space < rows {
                return invalid(&format!(
                    "uniq: sequence \"{name}\" — the {path} share of the pattern \"{pattern}\" is \
                     {rows} rows, and it can make at most {space} different strings. Give that \
                     branch a smaller share, widen it, or lower the count."
                ));
            }
        }
    }

    let mut values = column.values.clone();
    let mut seen: HashSet<String> = HashSet::new();
    let mut taken_in: HashMap<String, u64> = HashMap::new();
    let mut redo: Vec<usize> = Vec::new();
    for (row, value) in values.iter().enumerate() {
        if seen.contains(value) {
            redo.push(row);
            continue;
        }
        seen.insert(value.clone());
        *taken_in.entry(column.path_keys[row].clone()).or_insert(0) += 1;
    }

    for row in redo {
        let key = column.path_keys[row].clone();
        let space = column.path_space(&key).unwrap_or(column.total_space);
        let path = column.describe_path(&key);
        let mut repeats: u64 = 0;
        loop {
            match column.redraw(row, prng) {
                Some(candidate) if !seen.contains(&candidate) => {
                    seen.insert(candidate.clone());
                    values[row] = candidate;
                    *taken_in.entry(key.clone()).or_insert(0) += 1;
                    break;
                }
                _ => {}
            }
            repeats += 1;
            let taken = taken_in.get(&key).copied().unwrap_or(0);
            if repeats > stall_limit(space, taken) {
                let whose = if path.is_empty() {
                    "the pattern".to_string()
                } else {
                    format!("the {path} share of the pattern")
                };
                return invalid(&format!(
                    "uniq: sequence \"{name}\" — after {} unique values {whose} \"{pattern}\" \
                     produced only ones already drawn, {repeats} in a row. Its space of at most \
                     {space} strings is nearly used up, or fewer of them differ than its shape \
                     suggests. Widen the pattern, or lower the count.",
                    seen.len()
                ));
            }
        }
    }
    Ok(values)
}

/// Repeats in a row tolerated: at least 100 000, and twenty times the wait for a fresh value.
/// Integer ceiling division, so five languages stop on the same draw.
fn stall_limit(space: u64, produced: u64) -> u64 {
    let remaining = space.saturating_sub(produced).max(1);
    let wait = space.div_ceil(remaining);
    (20 * wait).max(100_000)
}

/// Why this gen cannot take the without-replacement path, for the refusal.
fn unsupported_reason(gen: &Gen) -> String {
    if gen.gen_type == "number" {
        return "its values are not a plain integer range — uniq supports value=\"a..b\" \
                without decimals=, distribution=, include=, exclude= or first_zero="
            .to_string();
    }
    format!(
        "its values cannot be enumerated (type=\"{}\") — uniq on a simple sequence supports \
         text lists, template packs, file columns, plain integer ranges, regex and \
         advanced_regex patterns",
        gen.gen_type
    )
}

fn plain_int_range(gen: &Gen) -> Option<(i64, i64)> {
    for blocked in [
        "distribution",
        "decimals",
        "include",
        "exclude",
        "first_zero",
    ] {
        if !gen.attr_or(blocked, "").trim().is_empty() {
            return None;
        }
    }
    let value = gen.attr_or("value", "");
    let (a, b) = value.trim().split_once("..")?;
    let lo: i64 = a.trim().parse().ok()?;
    let hi: i64 = b.trim().parse().ok()?;
    (lo <= hi).then_some((lo, hi))
}

/// The distinct values a gen can produce, with weights; duplicate strings merge.
fn pool_of(name: &str, gen: &Gen, env: &Env) -> EngineResult<Pool> {
    if gen.gen_type == "text" && gen.attr_or("percent", "").trim().is_empty() {
        let values: Vec<String> = gen
            .attr_or("value", "")
            .split(',')
            .map(|s| s.trim().to_string())
            .collect();
        return Ok(merge_duplicates(values, None));
    }
    if gen.gen_type == "template" {
        let path = gen.attr_or("value", "");
        if path == "person.b_day" || path == "date.range" {
            return not_a_list(name, path);
        }
        let locale = match gen.attr("local").map(str::trim).filter(|l| !l.is_empty()) {
            Some(l) => l.to_string(),
            None => env.config.locale_or_default().to_string(),
        };
        let entry = env.packs.load(path, &locale)?;
        if entry.is_generator() || entry.values.is_empty() {
            return not_a_list(name, path);
        }
        let weights = entry.percents.clone();
        return Ok(merge_duplicates(entry.values.clone(), weights));
    }
    if gen.gen_type == "file" && gen.attr_or("row", "").trim().is_empty() {
        let roots = env.packs.data_roots();
        if let Some(weighted) = file_gen::load_weighted(&gen.attrs, env.base_dir, roots)? {
            return Ok(merge_duplicates(weighted.values, Some(weighted.percents)));
        }
        let values = file_gen::load(&gen.attrs, env.base_dir, roots)?;
        return Ok(merge_duplicates(values, None));
    }
    invalid(&format!(
        "uniq: sequence \"{name}\" — {}",
        unsupported_reason(gen)
    ))
}

fn not_a_list<T>(name: &str, path: &str) -> EngineResult<T> {
    invalid(&format!(
        "uniq: sequence \"{name}\" — template \"{path}\" does not resolve to a value list, \
         so its values cannot be enumerated for a unique draw"
    ))
}

/// Merge duplicate strings, summing weights (missing weights count as 1).
fn merge_duplicates(values: Vec<String>, weights: Option<Vec<f64>>) -> Pool {
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut out_values: Vec<String> = Vec::new();
    let mut out_weights: Vec<f64> = Vec::new();
    for (i, value) in values.into_iter().enumerate() {
        let weight = weights
            .as_ref()
            .and_then(|w| w.get(i))
            .copied()
            .unwrap_or(1.0);
        match index.get(&value) {
            Some(&at) => out_weights[at] += weight,
            None => {
                index.insert(value.clone(), out_values.len());
                out_values.push(value);
                out_weights.push(weight);
            }
        }
    }
    Pool {
        values: out_values,
        weights: out_weights,
    }
}
