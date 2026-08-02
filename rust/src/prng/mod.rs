//! Seeded pseudo-random numbers, and the two tricks built on top of them.
//!
//! [`Sfc32`] is the foundation of TDC's cross-language guarantee: the same seed
//! has to produce the same sequence of doubles here, in the TypeScript
//! reference, in Java, in Python and in C#. If this module drifts by one bit,
//! every generated dataset drifts with it.

pub mod permute;
pub mod seekable;

/// Derive four 32-bit state words from a seed string.
///
/// The one place a port silently diverges is the seed string itself.
/// JavaScript's `charCodeAt` returns a UTF-16 **code unit**, and so does
/// indexing a Java, C# or Python string here. Rust's `str` iterates code
/// *points*, which is the same thing only up to U+FFFF — so this walks
/// [`str::encode_utf16`] instead. A seed holding an emoji would otherwise
/// produce different numbers in Rust than in the other four, and nothing would
/// say so.
///
/// The mixing constants overflow on purpose. Rust panics on overflow in a debug
/// build, so every multiply and add is spelled `wrapping_*`: that is not a
/// silenced warning but the algorithm, which is defined on 32-bit two's
/// complement arithmetic.
pub fn cyrb128(seed: &str) -> [i32; 4] {
    let mut h1: i32 = 1779033703;
    let mut h2: i32 = -1150833019; // 3144134277 as a signed 32-bit int
    let mut h3: i32 = 1013904242;
    let mut h4: i32 = -1521486534; // 2773480762

    for unit in seed.encode_utf16() {
        let k = i32::from(unit);
        h1 = h2 ^ (h1 ^ k).wrapping_mul(597399067);
        h2 = h3 ^ (h2 ^ k).wrapping_mul(-1425107063); // 2869860233
        h3 = h4 ^ (h3 ^ k).wrapping_mul(951274213);
        h4 = h1 ^ (h4 ^ k).wrapping_mul(-1578923117); // 2716044179
    }

    h1 = (h3 ^ ushr(h1, 18)).wrapping_mul(597399067);
    h2 = (h4 ^ ushr(h2, 22)).wrapping_mul(-1425107063);
    h3 = (h1 ^ ushr(h3, 17)).wrapping_mul(951274213);
    h4 = (h2 ^ ushr(h4, 19)).wrapping_mul(-1578923117);
    [h1 ^ h2 ^ h3 ^ h4, h2 ^ h1, h3 ^ h1, h4 ^ h1]
}

/// A logical right shift on a signed word — JavaScript's and Java's `>>>`.
///
/// Rust's `>>` on `i32` is arithmetic and drags the sign bit along. Doing that
/// here gives a different stream for any seed whose state goes negative, which
/// is most of them.
#[inline]
pub(crate) fn ushr(x: i32, n: u32) -> i32 {
    ((x as u32) >> n) as i32
}

/// A generator from a seed string.
pub fn create(seed: &str) -> Sfc32 {
    let s = cyrb128(seed);
    Sfc32::new(s[0], s[1], s[2], s[3])
}

/// An sfc32 generator over four state words. Each call returns a double in `[0, 1)`.
///
/// Stateful by nature. Two threads sharing one instance would interleave their
/// draws and destroy reproducibility, which is the whole point of it — so it is
/// taken by `&mut`, and the borrow checker makes that mistake unrepresentable
/// rather than merely documented.
#[derive(Clone, Debug)]
pub struct Sfc32 {
    a: i32,
    b: i32,
    c: i32,
    d: i32,
}

impl Sfc32 {
    pub fn new(a: i32, b: i32, c: i32, d: i32) -> Self {
        Self { a, b, c, d }
    }

    /// The next double in `[0, 1)`.
    ///
    /// Named `next` deliberately, and not made an `Iterator`. It is `next` in
    /// all five implementations, so a reader holding two of them side by side
    /// finds the same call; and an `Iterator` would hand back `Option<f64>`,
    /// putting an `unwrap` at every draw in the engine for a `None` that cannot
    /// happen.
    #[allow(clippy::should_implement_trait)]
    pub fn next(&mut self) -> f64 {
        let mut t = self.a.wrapping_add(self.b);
        self.a = self.b ^ ushr(self.b, 9);
        self.b = self.c.wrapping_add(self.c << 3);
        self.c = (self.c << 21) | ushr(self.c, 11);
        self.d = self.d.wrapping_add(1);
        t = t.wrapping_add(self.d);
        self.c = self.c.wrapping_add(t);
        // Read as unsigned: a negative `t` would otherwise give a negative double.
        f64::from(t as u32) / 4294967296.0
    }
}
