//! Draws shaped the way the reference shapes them.
//!
//! Two functions, and both matter more than they look. Every generator reaches
//! for these rather than doing the arithmetic inline, because *how many times*
//! the stream is advanced and *how* a draw is mapped onto a range are part of
//! the cross-language contract — a port that wrote `as usize` instead of
//! `floor()` somewhere would agree on most values and disagree on the ones
//! sitting exactly on a boundary.

use crate::prng::Sfc32;

/// `[min, max)` over 32-bit integers.
pub fn next_int(prng: &mut Sfc32, min: i32, max: i32) -> i32 {
    (prng.next() * f64::from(max - min) + f64::from(min)).floor() as i32
}

/// `[min, max)` over 64-bit integers — the range form can exceed what an `i32` holds.
pub fn next_long(prng: &mut Sfc32, min: i64, max: i64) -> i64 {
    (prng.next() * (max - min) as f64 + min as f64).floor() as i64
}

/// One of the values, uniformly.
pub fn pick<T: Clone>(prng: &mut Sfc32, values: &[T]) -> T {
    let at = (prng.next() * values.len() as f64).floor() as usize;
    values[at.min(values.len() - 1)].clone()
}
