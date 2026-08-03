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
use crate::generators::file as file_gen;
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

/// Why this gen cannot take the without-replacement path, for the refusal.
fn unsupported_reason(gen: &Gen) -> String {
    if gen.gen_type == "number" {
        return "its values are not a plain integer range — uniq supports value=\"a..b\" \
                without decimals=, distribution=, include=, exclude= or first_zero="
            .to_string();
    }
    format!(
        "its values cannot be enumerated (type=\"{}\") — uniq on a simple sequence supports \
         text lists, template packs, file columns and plain integer ranges",
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
