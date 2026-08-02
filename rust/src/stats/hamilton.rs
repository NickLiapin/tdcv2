//! Hamilton's largest-remainder method: split `count` rows across values in the
//! declared percentages, exactly.
//!
//! This is what makes `percent="60,40"` produce 60 and 40 rather than "about" 60
//! and 40. Each value first takes its whole share; the rows left over by
//! rounding go to the largest fractional remainders.
//!
//! Two details decide whether a port matches the reference, and both are easy to
//! get wrong:
//!
//! 1. **Tie order.** Values with equal remainders are served lowest index first.
//!    Only when a tie group is larger than the number of rows left does the
//!    generator get consulted, one draw per row, from a pool that shrinks as it
//!    goes.
//! 2. **Draw accounting.** Tie-breaking and the final shuffle both consume from
//!    the same generator, in that order. Drawing a different number of times
//!    leaves the generator in a different state, and everything generated
//!    afterwards diverges — even though the counts themselves would still look
//!    correct.
//!
//! Verified against `fixtures/cross-language/hamilton-vectors.json`.

use crate::prng::Sfc32;

/// How many rows each value receives.
pub fn counts_per_value(count: i32, percents: &[f64], prng: &mut Sfc32) -> Vec<i32> {
    let card_percent = 100.0 / f64::from(count);
    let mut counts = vec![0i32; percents.len()];
    let mut remainders = vec![0f64; percents.len()];

    let mut filled = 0i32;
    for (i, &percent) in percents.iter().enumerate() {
        let raw_cells = percent / card_percent;
        // Truncation toward zero, as `Math.trunc` does — not `floor`, which
        // differs for a negative share and would not error, only drift.
        let whole = raw_cells.trunc() as i32;
        counts[i] = whole;
        remainders[i] = raw_cells % 1.0;
        filled += whole;
    }

    let mut unallocated = count - filled;
    if unallocated <= 0 {
        return counts;
    }

    // Remainder descending, index ascending — the order the reference walks in.
    // `sort_by` is stable, so sorting on the remainder alone would already keep
    // the index order; the tie-break is spelled out anyway, because relying on
    // an unstated property of the sort is how a port drifts when someone
    // "optimises" it to `sort_unstable_by`.
    let mut order: Vec<usize> = (0..remainders.len()).collect();
    order.sort_by(|&a, &b| {
        remainders[b]
            .partial_cmp(&remainders[a])
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.cmp(&b))
    });

    let mut at = 0usize;
    while unallocated > 0 && at < order.len() {
        let remainder = remainders[order[at]];
        let mut end = at;
        while end < order.len() && remainders[order[end]] == remainder {
            end += 1;
        }

        let group_size = (end - at) as i32;
        if group_size <= unallocated {
            for &idx in &order[at..end] {
                counts[idx] += 1;
                unallocated -= 1;
            }
            at = end;
            continue;
        }

        // More values tied than rows left: pick one at random per row, from a
        // pool that shrinks with each pick. One draw per row, which is what
        // keeps the generator in step.
        let mut pool: Vec<usize> = order[at..end].to_vec();
        while unallocated > 0 {
            let pick = (prng.next() * pool.len() as f64).floor() as usize;
            counts[pool[pick]] += 1;
            pool.remove(pick);
            unallocated -= 1;
        }
    }

    counts
}

/// The materialised, shuffled sequence of `count` values.
pub fn distribute<T: Clone>(
    count: i32,
    values: &[T],
    percents: &[f64],
    prng: &mut Sfc32,
) -> Vec<T> {
    let counts = counts_per_value(count, percents, prng);
    let mut sequence: Vec<T> = Vec::with_capacity(count.max(0) as usize);
    for (i, value) in values.iter().enumerate() {
        for _ in 0..counts.get(i).copied().unwrap_or(0) {
            sequence.push(value.clone());
        }
    }
    shuffle(prng, &mut sequence);
    sequence
}

/// Fisher-Yates, from the end backwards.
///
/// The direction is not a detail. Walking the array the other way consumes the
/// same number of draws but pairs them with different indices, so a port that
/// flips it produces a shuffle that is equally valid and not the same one.
pub fn shuffle<T>(prng: &mut Sfc32, values: &mut [T]) {
    if values.is_empty() {
        return;
    }
    for i in (1..values.len()).rev() {
        let j = (prng.next() * (i + 1) as f64).floor() as usize;
        values.swap(i, j);
    }
}
