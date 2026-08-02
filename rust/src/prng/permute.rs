//! A shuffle you can evaluate at one position without performing it.
//!
//! This is what lets an exact quota be resolved row by row. Laying out a
//! `percent="20,80"` split is easy — twenty per cent of the slots, then eighty —
//! but the result would come out sorted, every `A` before every `B`. Shuffling
//! fixes that and normally requires the whole column in memory.
//!
//! A format-preserving permutation removes the requirement: a small Feistel
//! network over the index space is a bijection, so row `i` can ask which slot it
//! owns and get an answer consistent with every other row's, without any of them
//! existing.
//!
//! The cycle-walking loop is what keeps it exact for a size that is not a power
//! of two: the network works over a padded domain, and any result past the end
//! is fed back through until it lands inside. It terminates because the network
//! is a bijection on the padded space.

use super::{cyrb128, ushr};

const ROUNDS: i32 = 4;

/// A key private to one stream, so two columns shuffle independently.
pub fn key(seed: &str, stream_id: &str) -> i32 {
    cyrb128(&format!("{seed}|perm|{stream_id}"))[0]
}

/// The slot row `index` owns, among `n`.
pub fn apply(index: i32, n: i32, key: i32) -> i32 {
    if n <= 1 {
        return 0;
    }
    let half = half_size_for(n);
    let mut x = index;
    loop {
        x = forward(x, half, key);
        if x < n {
            return x;
        }
    }
}

/// The inverse: which row owns `slot`.
pub fn unapply(slot: i32, n: i32, key: i32) -> i32 {
    if n <= 1 {
        return 0;
    }
    let half = half_size_for(n);
    let mut x = slot;
    loop {
        x = inverse(x, half, key);
        if x < n {
            return x;
        }
    }
}

/// The padded domain: two equal halves whose product covers `n`.
fn half_size_for(n: i32) -> i32 {
    let bits = ((f64::from(n).ln() / std::f64::consts::LN_2).ceil() as i32).max(2);
    let half = (f64::from(bits) / 2.0).ceil() as i32;
    1 << half
}

/// The round function.
///
/// The mixing constants deliberately overflow and the shifts must be logical,
/// as Java's `>>>` is. An arithmetic shift here gives a different permutation
/// and the same seed lands on different rows.
fn round_fn(r: i32, round: i32, key: i32) -> i32 {
    // Each constant is written as the signed 32-bit pattern it is. `0x9e3779b1`
    // is above i32::MAX, so it is spelled as a u32 and cast — writing it bare
    // would not compile, and widening it to i64 would change the arithmetic.
    let mut h = r ^ (round + 1).wrapping_mul(0x9e3779b1_u32 as i32);
    h = (h ^ ushr(h, 16)).wrapping_mul(0x85ebca6b_u32 as i32);
    h = (h ^ ushr(h, 13)).wrapping_mul(0xc2b2ae35_u32 as i32);
    h = (h ^ key).wrapping_mul(0x27d4eb2f);
    h ^ ushr(h, 16)
}

fn forward(x: i32, half_size: i32, key: i32) -> i32 {
    let mut left = x / half_size;
    let mut right = x % half_size;
    for round in 0..ROUNDS {
        let mixed = ((round_fn(right, round, key) as u32) % (half_size as u32)) as i32;
        let next_right = left ^ mixed;
        left = right;
        right = next_right;
    }
    left * half_size + right
}

fn inverse(y: i32, half_size: i32, key: i32) -> i32 {
    let mut left = y / half_size;
    let mut right = y % half_size;
    for round in (0..ROUNDS).rev() {
        let prev_right = left;
        let mixed = ((round_fn(prev_right, round, key) as u32) % (half_size as u32)) as i32;
        let prev_left = right ^ mixed;
        left = prev_left;
        right = prev_right;
    }
    left * half_size + right
}
