//! Draws that can be taken for one row without taking them for any other.
//!
//! The in-memory engine walks one generator from the start, so row 900 000's
//! value exists only after the 899 999 before it. That is fine when the whole
//! run is in memory and impossible when it is not.
//!
//! Here each draw is keyed by `seed | streamId | index`, so a row's values are a
//! function of its own number. Nothing has to be kept, nothing has to be
//! replayed, and a run of any size costs the memory of one row. It is also what
//! lets separate workers each render a slice of the same file and agree at the
//! seams.

use super::{cyrb128, Sfc32};

/// Half of a 32-bit unit in the last place — see [`open_unit`].
const HALF_ULP: f64 = 0.5 / 4294967296.0;

/// A generator private to one row of one stream.
pub fn generator(seed: &str, stream_id: &str, index: i32) -> Sfc32 {
    let key = format!("{seed}|{stream_id}|{index}");
    let s = cyrb128(&key);
    Sfc32::new(s[0], s[1], s[2], s[3])
}

pub fn next(seed: &str, stream_id: &str, index: i32) -> f64 {
    generator(seed, stream_id, index).next()
}

/// An integer in `[0, n)` for this row.
pub fn next_int(seed: &str, stream_id: &str, index: i32, n: i32) -> i32 {
    if n <= 1 {
        return 0;
    }
    (next(seed, stream_id, index) * f64::from(n)).floor() as i32
}

/// Nudge a raw draw into the open interval `(0, 1)`.
///
/// sfc32 emits values in `[0, 1)`, and inverse-CDF sampling takes logarithms —
/// at exactly zero those are infinite. The shift is about 1e-10 and changes
/// nothing statistically.
pub fn open_unit(u: f64) -> f64 {
    (u + HALF_ULP).clamp(HALF_ULP, 1.0 - HALF_ULP)
}

/// `count` uniforms in `(0, 1)` for one row — what a fixed-draw sampler needs.
pub fn uniforms(seed: &str, stream_id: &str, index: i32, count: usize) -> Vec<f64> {
    let mut gen = generator(seed, stream_id, index);
    (0..count).map(|_| open_unit(gen.next())).collect()
}

/// A double as the 16 hex digits of its IEEE-754 image.
fn bits_hex(value: f64) -> String {
    format!("{:016x}", value.to_bits())
}

/// A deterministic value in [0, 1) from a pair of numbers — `hash(n, salt)`.
/// 
/// The key is built from the IEEE-754 BIT PATTERNS of the two arguments, not from
/// their decimal forms: `salt` is any double, and the shortest decimal spelling of
/// a double differs between languages, while those 64 bits are pinned by the
/// standard and printing an integer as hex is exact everywhere. The mixing is
/// cyrb128 and the stream is sfc32 — the PRNG the rest of TDC already runs on.
pub fn hash_unit(n: f64, salt: f64) -> f64 {
    let key = format!("{}|{}", bits_hex(n), bits_hex(salt));
    generator("hash", &key, 0).next()
}

/// Smooth one-dimensional value noise — `noise(t, scale, salt)`.
/// 
/// A drifting baseline is not three sine waves: modulate those however you like and
/// a spectrum still shows three pure tones. Here each lattice point is an
/// independent draw and only the interpolation between them is smooth, so the
/// spectrum is broad.
/// 
/// `scale` is the wavelength in rows; `salt` picks the series. The easing is the
/// classic smoothstep, u*u*(3-2u), zero at both ends with zero slope, so no corner
/// appears where one cell meets the next. The interpolation is a*(1-u) + b*u for
/// the same reason `lerp` uses it: the lattice points come out EXACTLY equal to
/// `hash` there, so a cell boundary is continuous to the last bit.
/// 
/// A `scale` of zero divides by zero and the answer is NaN — the same answer
/// `sqrt(-1)` gives here.
pub fn noise_unit(t: f64, scale: f64, salt: f64) -> f64 {
    let x = t / scale;
    let cell = x.floor();
    let u = x - cell;
    let eased = u * u * (3.0 - 2.0 * u);
    let a = hash_unit(cell, salt);
    let b = hash_unit(cell + 1.0, salt);
    a * (1.0 - eased) + b * eased
}
